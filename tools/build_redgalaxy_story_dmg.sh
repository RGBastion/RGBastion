#!/usr/bin/env bash
set -Eeuo pipefail

# Build RedGalaxy Bastion and/or RedUniverse Bastion Mac DMGs.
#
# Usage:
#   ./tools/build_redgalaxy_story_dmg.sh                 # both brands
#   BASTION_BRAND=redgalaxy ./tools/build_redgalaxy_story_dmg.sh
#   BASTION_BRAND=reduniverse ./tools/build_redgalaxy_story_dmg.sh
#   BASTION_BRAND=both ./tools/build_redgalaxy_story_dmg.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
BASTION_VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/bastion_version.txt" 2>/dev/null || true)"
BASTION_VERSION="${BASTION_VERSION:-1.0.5}"
BASTION_BRAND="${BASTION_BRAND:-both}"

DIST_DIR="$PROJECT_DIR/dist"
ICON_ICNS="$PROJECT_DIR/dist/build/RedGalaxy.icns"
BG_PNG="$PROJECT_DIR/dist/build/dmg-background.png"
SERVER_SRC="$SCRIPT_DIR/redgalaxy_native_server.c"
HOST_OBJC_SRC="$SCRIPT_DIR/redgalaxy_native_host.m"
HOST_SWIFT_SRC="$SCRIPT_DIR/redgalaxy_native_host.swift"

if [[ ! -f "$ICON_ICNS" ]]; then
  chmod +x "$SCRIPT_DIR/make_redgalaxy_icon.sh" "$SCRIPT_DIR/make_dmg_background.sh"
  "$SCRIPT_DIR/make_redgalaxy_icon.sh"
  "$SCRIPT_DIR/make_dmg_background.sh"
fi

build_one_brand() {
  local brand="$1"
  local product_name bundle_id dmg_slug brand_define build_dir app_dir dmg_root dmg_rw dmg_path
  local server_bin host_bin volume_name host_built app_executable
  local host_exec_name server_exec_name web_dir

  case "$brand" in
    redgalaxy)
      product_name="RedGalaxy Bastion"
      bundle_id="local.redgalaxy.bastion"
      dmg_slug="RedGalaxy-Bastion"
      brand_define="BASTION_BRAND_REDGALAXY"
      host_exec_name="redgalaxy-bastion-host"
      server_exec_name="redgalaxy-bastion-server"
      ;;
    reduniverse)
      product_name="RedUniverse Bastion"
      bundle_id="local.reduniverse.bastion"
      dmg_slug="RedUniverse-Bastion"
      brand_define="BASTION_BRAND_REDUNIVERSE"
      host_exec_name="reduniverse-bastion-host"
      server_exec_name="reduniverse-bastion-server"
      ;;
    *)
      echo "Unknown BASTION_BRAND='$brand' (use redgalaxy|reduniverse|both)" >&2
      exit 1
      ;;
  esac

  chmod +x "$SCRIPT_DIR/prepare_redgalaxy_story_web.sh"
  "$SCRIPT_DIR/prepare_redgalaxy_story_web.sh" --brand "$brand"
  web_dir="$PROJECT_DIR/artifacts/redgalaxy-story-web-$brand"
  [[ -f "$web_dir/index.html" ]] || {
    echo "Missing story web assets: $web_dir/index.html" >&2
    exit 1
  }
  if [[ "$brand" == "redgalaxy" ]]; then
    if rg -q "RedUniverse Bastion" "$web_dir/story/i18n.js" "$web_dir/story/autopilot.js"; then
      echo "Refusing to package RedGalaxy Bastion with RedUniverse Bastion UI strings." >&2
      exit 1
    fi
    if ! rg -q '"app.title": "RedGalaxy Bastion"' "$web_dir/story/i18n.js"; then
      echo "RedGalaxy story i18n missing RedGalaxy Bastion app.title" >&2
      exit 1
    fi
    main_js="$(rg -o 'assets/index-[^\"'\'']+\.js' "$web_dir/index.html" | head -1 || true)"
    if [[ -z "$main_js" || ! -f "$web_dir/$main_js" ]]; then
      echo "RedGalaxy Bastion missing game entry JS" >&2
      exit 1
    fi
    if rg -q 'aws-prod-api\.reduniverse\.space|aws-test-api\.reduniverse\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedGalaxy Bastion with RedUniverse game APIs (reduniverse.space)." >&2
      exit 1
    fi
    if ! rg -q 'redgalaxygame\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedGalaxy Bastion without redgalaxygame.space game APIs." >&2
      exit 1
    fi
    if rg -q 'reduniverse\.space' "$web_dir/story/autopilot.js"; then
      echo "Refusing: RedGalaxy story/autopilot.js still references reduniverse.space" >&2
      exit 1
    fi
  elif [[ "$brand" == "reduniverse" ]]; then
    main_js="$(rg -o 'assets/index-[^\"'\'']+\.js' "$web_dir/index.html" | head -1 || true)"
    if [[ -z "$main_js" || ! -f "$web_dir/$main_js" ]]; then
      echo "RedUniverse Bastion missing game entry JS" >&2
      exit 1
    fi
    if rg -q 'aws-prod-api\.redgalaxygame\.space|aws-api\.redgalaxygame\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedUniverse Bastion with RedGalaxy game APIs (redgalaxygame.space)." >&2
      exit 1
    fi
    if ! rg -q 'reduniverse\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedUniverse Bastion without reduniverse.space game APIs." >&2
      exit 1
    fi
  fi

  build_dir="$DIST_DIR/build-story-$brand"
  app_dir="$DIST_DIR/${product_name}.app"
  dmg_root="$DIST_DIR/dmg-story-root-$brand"
  dmg_rw="$build_dir/${dmg_slug}.rw.dmg"
  dmg_path="$DIST_DIR/${dmg_slug}.dmg"
  server_bin="$build_dir/$server_exec_name"
  host_bin="$build_dir/$host_exec_name"
  volume_name="$product_name"

  echo "=== Building $product_name (brand=$brand) ==="
  mkdir -p "$build_dir"

  echo "Compiling native server ($brand → $server_exec_name)..."
  if cc -O2 -Wall -Wextra -std=c11 -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 \
    -D"${brand_define}=1" "$SERVER_SRC" -o "$server_bin" 2>/dev/null; then
    echo "Built universal arm64/x86_64 server."
  else
    cc -O2 -Wall -Wextra -std=c11 -D"${brand_define}=1" "$SERVER_SRC" -o "$server_bin"
    echo "Built native-architecture server."
  fi

  host_built=0
  if [[ -f "$HOST_OBJC_SRC" ]]; then
    if cc -O2 -Wall -Wextra -fobjc-arc -mmacosx-version-min=11.0 \
      -arch arm64 -arch x86_64 \
      -D"${brand_define}=1" \
      -framework Cocoa -framework WebKit \
      "$HOST_OBJC_SRC" -o "$host_bin"; then
      echo "Built universal arm64/x86_64 host ($host_exec_name)."
      host_built=1
    else
      echo "Objective-C host compilation failed; trying Swift fallback." >&2
    fi
  fi

  if [[ "$host_built" == "0" ]] && command -v xcrun >/dev/null 2>&1 && [[ -f "$HOST_SWIFT_SRC" ]]; then
    if CLANG_MODULE_CACHE_PATH="$build_dir/module-cache-swift" xcrun swiftc -O \
      -framework Foundation -framework Cocoa -framework WebKit \
      -D"$brand_define" \
      -target "$(uname -m)-apple-macos11.0" \
      "$HOST_SWIFT_SRC" -o "$host_bin"; then
      echo "Built native-architecture Swift host ($host_exec_name)."
      host_built=1
    else
      echo "Host wrapper compilation failed; fallback to server-only launcher." >&2
    fi
  fi

  rm -rf "$app_dir" "$dmg_root" "$dmg_rw" "$dmg_path"
  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources" "$dmg_root/.background"

  cp "$server_bin" "$app_dir/Contents/MacOS/$server_exec_name"
  chmod +x "$app_dir/Contents/MacOS/$server_exec_name"
  if [[ "$host_built" == "1" ]]; then
    cp "$host_bin" "$app_dir/Contents/MacOS/$host_exec_name"
    chmod +x "$app_dir/Contents/MacOS/$host_exec_name"
  fi
  cp -R "$web_dir" "$app_dir/Contents/Resources/web"
  cp "$ICON_ICNS" "$app_dir/Contents/Resources/AppIcon.icns"
  cp "$PROJECT_DIR/bin/redgalaxy-mac-runner" "$app_dir/Contents/Resources/redgalaxy-mac-runner"
  cp "$PROJECT_DIR/tools/extract_redgalaxy_web.py" "$app_dir/Contents/Resources/extract_redgalaxy_web.py"
  cp "$PROJECT_DIR/tools/apply_bastion_patches.py" "$app_dir/Contents/Resources/apply_bastion_patches.py"
  chmod +x "$app_dir/Contents/Resources/redgalaxy-mac-runner"
  chmod +x "$app_dir/Contents/Resources/apply_bastion_patches.py"
  chmod +x "$SCRIPT_DIR/bundle_brotli_runtime.sh"
  "$SCRIPT_DIR/bundle_brotli_runtime.sh" "$app_dir/Contents/Resources" || true

  app_executable="$server_exec_name"
  if [[ "$host_built" == "1" && -x "$app_dir/Contents/MacOS/$host_exec_name" ]]; then
    app_executable="$host_exec_name"
  fi

  cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$product_name</string>
  <key>CFBundleExecutable</key>
  <string>$app_executable</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$product_name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$BASTION_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BASTION_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

  printf 'APPL????' > "$app_dir/Contents/PkgInfo"

  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$app_dir" >/dev/null 2>&1 || true
  fi

  cp -R "$app_dir" "$dmg_root/"
  ln -s /Applications "$dmg_root/Applications"
  cp "$BG_PNG" "$dmg_root/.background/background.png"
  cp "$ICON_ICNS" "$dmg_root/.VolumeIcon.icns"
  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a C "$dmg_root"
  fi

  echo "Creating $product_name DMG..."
  hdiutil create -volname "$volume_name" -srcfolder "$dmg_root" -ov -format UDRW "$dmg_rw"

  local mount_output mount_dir
  mount_output="$(hdiutil attach "$dmg_rw" -nobrowse -readwrite 2>&1)"
  mount_dir="$(printf '%s\n' "$mount_output" | grep -o '/Volumes/.*' | tail -1)"
  [[ -n "$mount_dir" && -d "$mount_dir" ]] || {
    echo "Failed to mount DMG for styling." >&2
    exit 1
  }

  cp "$ICON_ICNS" "$mount_dir/.VolumeIcon.icns"
  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a C "$mount_dir"
  fi

  /usr/bin/osascript - "$mount_dir" "$volume_name" "$product_name.app" <<'APPLESCRIPT'
on run argv
  set mountPath to item 1 of argv
  set volumeName to item 2 of argv
  set appItemName to item 3 of argv
  set bgFile to POSIX file (mountPath & "/.background/background.png")
  tell application "Finder"
    tell disk volumeName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {120, 120, 780, 520}
      set theViewOptions to icon view options of container window
      set arrangement of theViewOptions to not arranged
      set icon size of theViewOptions to 128
      try
        set background picture of theViewOptions to bgFile
      end try
      set position of item appItemName of container window to {170, 210}
      set position of item "Applications" of container window to {470, 210}
      close
      open
      update without registering applications
      delay 1
    end tell
  end tell
end run
APPLESCRIPT

  sync
  hdiutil detach "$mount_dir" >/dev/null
  hdiutil convert "$dmg_rw" -format UDZO -imagekey zlib-level=9 -o "$dmg_path" >/dev/null
  rm -f "$dmg_rw"

  echo "Created: $dmg_path"
}

case "$BASTION_BRAND" in
  both|all|"")
    build_one_brand redgalaxy
    build_one_brand reduniverse
    ;;
  redgalaxy|reduniverse)
    build_one_brand "$BASTION_BRAND"
    ;;
  *)
    echo "Unknown BASTION_BRAND='$BASTION_BRAND' (use redgalaxy|reduniverse|both)" >&2
    exit 1
    ;;
esac

echo "Bastion DMG build complete."
